/**
 * The single configuration boundary of the server.
 *
 * This module is the only reader of `process.env` in the build: every other module receives the
 * resolved values through `ServerConfig`, so there is exactly one place where an environment
 * variable is named, defaulted and parsed. Resolved values are never logged, so the credential this
 * module holds cannot reach a log line or a response body by way of configuration.
 *
 * Three variables are deliberately absent. The 30 000 ms analysis budget is the `ANALYSIS_BUDGET_MS`
 * constant in the shared package, not a variable, so no deployment can drift from the value the
 * tests assert. The prompt version is read from the prompt library at request time, so no
 * environment setting may influence the built-in instruction text. And there are no authentication
 * variables at all, because this build has no authentication.
 */
import { resolve as resolvePath } from 'node:path';

/** A value set supplied by a caller, which takes precedence over the process environment. */
type EnvironmentOverrides = Partial<Record<string, string | undefined>>;

/** Port used when `PORT` is unset, blank, non-integer or outside the valid range. */
const DEFAULT_PORT = 3001;

/** Lowest accepted `PORT`; zero asks the operating system for an ephemeral port. */
const MIN_PORT = 0;

/** Highest accepted `PORT`. */
const MAX_PORT = 65535;

/** Loopback bind address used when `HOST` is unset or blank. */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Relative directory, resolved against the process working directory, used when `DATA_DIR` is unset
 * or blank.
 */
const DEFAULT_DATA_DIR = '.data';

/** Vision-capable slug used when `OPENROUTER_MODEL` is unset or blank. */
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

/**
 * OpenRouter API base used when `OPENROUTER_BASE_URL` is unset or blank; the adapter appends the
 * request path to it.
 */
const DEFAULT_OPEN_ROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** The only `STUB_PROVIDER` value that selects the replay provider. */
const STUB_PROVIDER_ENABLED = '1';

/**
 * The resolved configuration of the server, assembled once per `loadConfig` call and frozen.
 *
 * Every member names the environment variable it comes from, its default and its effect, because
 * this interface is the documentation of the configuration contract.
 */
export interface ServerConfig {
  /**
   * `OPENROUTER_API_KEY`; default `null`.
   *
   * The only model credential in the build. `null` when unset or blank — never an empty string — so
   * no adapter can build `Authorization: Bearer ` with an empty credential.
   */
  readonly openRouterApiKey: string | null;

  /**
   * `OPENROUTER_BASE_URL`; default `https://openrouter.ai/api/v1`.
   *
   * Stored exactly as configured: the provider adapter composes the request path, so no trailing
   * slash is stripped and no path is appended here.
   */
  readonly openRouterBaseUrl: string;

  /**
   * `OPENROUTER_REFERER`; default `null`.
   *
   * Sent as the optional `HTTP-Referer` attribution header when present.
   */
  readonly openRouterReferer: string | null;

  /**
   * `OPENROUTER_APP_TITLE`; default `null`.
   *
   * Sent as the optional `X-Title` attribution header when present.
   */
  readonly openRouterAppTitle: string | null;

  /**
   * `OPENROUTER_MODEL`; default `google/gemini-2.5-flash`.
   *
   * The one vision-capable slug used for both the extraction and the synthesis call, and the value
   * `GET /api/v1/health` reports.
   */
  readonly model: string;

  /**
   * `DATA_DIR`; default `.data`, always resolved to an absolute path.
   *
   * Where analysis documents and their image bytes are written. The default sits outside version
   * control.
   */
  readonly dataDir: string;

  /**
   * `PORT`; default `3001`.
   *
   * Accepted from `0` to `65535` inclusive, where `0` asks the operating system for an ephemeral
   * port. Any unparseable or out-of-range value falls back to the default instead of failing the
   * start, so the server always comes up.
   */
  readonly port: number;

  /**
   * `HOST`; default `127.0.0.1`.
   *
   * The bind address. The loopback default is a compensating control rather than an accident: the
   * API is unauthenticated, so it is reachable from the local machine only unless a deployment sets
   * this explicitly.
   */
  readonly host: string;

  /**
   * `STUB_PROVIDER`; default `false`.
   *
   * `true` only for the exact value `1`, which selects the replay provider instead of the OpenRouter
   * adapter. Every other value, including `0`, `true` and `yes`, leaves the real adapter in place.
   */
  readonly stubProvider: boolean;

  /**
   * Derived from `OPENROUTER_API_KEY`; default `false`.
   *
   * `true` exactly when the trimmed key is non-empty. This is the only member that expresses key
   * presence, so the client learns whether a provider is configured without learning the key.
   */
  readonly providerConfigured: boolean;
}

/**
 * Resolve the raw value of one variable, preferring a caller-supplied override.
 *
 * An override present as an own property wins outright, including an explicit `undefined`, which
 * asks for the variable to be treated as unset. Only an override that is absent entirely falls
 * through to `process.env`, which is what lets a test pin the configuration while the developer's
 * shell exports real values.
 *
 * @param overrides - Values that take precedence over the process environment.
 * @param name - The environment variable to resolve.
 * @returns The untrimmed value, or `undefined` when the variable is unset.
 */
function readRawValue(overrides: EnvironmentOverrides | undefined, name: string): string | undefined {
  if (overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name];
  }

  return process.env[name];
}

/**
 * Resolve one variable as text, treating a blank value as unset.
 *
 * @param overrides - Values that take precedence over the process environment.
 * @param name - The environment variable to resolve.
 * @returns The trimmed value, or `undefined` when the variable is unset or blank.
 */
function readText(overrides: EnvironmentOverrides | undefined, name: string): string | undefined {
  const raw = readRawValue(overrides, name);

  if (raw === undefined) {
    return undefined;
  }

  const trimmed = raw.trim();

  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve one variable as text with a default applied when it is unset or blank.
 *
 * @param overrides - Values that take precedence over the process environment.
 * @param name - The environment variable to resolve.
 * @param fallback - Value used when the variable is unset or blank.
 * @returns The trimmed value, or the fallback.
 */
function readTextOrDefault(
  overrides: EnvironmentOverrides | undefined,
  name: string,
  fallback: string,
): string {
  return readText(overrides, name) ?? fallback;
}

/**
 * Resolve `PORT` as a base-10 integer within the valid range.
 *
 * `Number` rather than `parseInt` is used so a value such as `3001abc` is rejected instead of being
 * read as its numeric prefix. An unusable value yields the default rather than an error, because the
 * server must start without any working configuration.
 *
 * @param overrides - Values that take precedence over the process environment.
 * @returns The port, or `3001`.
 */
function readPort(overrides: EnvironmentOverrides | undefined): number {
  const raw = readText(overrides, 'PORT');

  if (raw === undefined) {
    return DEFAULT_PORT;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    return DEFAULT_PORT;
  }

  return parsed;
}

/**
 * Resolve `STUB_PROVIDER`, which is on only for the exact value `1`.
 *
 * @param overrides - Values that take precedence over the process environment.
 * @returns Whether the replay provider is selected.
 */
function readStubProvider(overrides: EnvironmentOverrides | undefined): boolean {
  return readText(overrides, 'STUB_PROVIDER') === STUB_PROVIDER_ENABLED;
}

/**
 * Load the server configuration from the process environment and any caller-supplied overrides.
 *
 * Sources are read on every call and nothing is cached at module scope, so repeated calls with
 * different overrides see different results. The returned object is frozen: configuration is read
 * in many places and written in none.
 *
 * @param overrides - Values that take precedence over `process.env`; an explicit `undefined` treats
 *   that variable as unset instead of falling through to the process environment.
 * @returns The frozen, fully resolved configuration.
 */
export function loadConfig(overrides?: EnvironmentOverrides): ServerConfig {
  const openRouterApiKey = readText(overrides, 'OPENROUTER_API_KEY') ?? null;

  const config: ServerConfig = {
    openRouterApiKey,
    openRouterBaseUrl: readTextOrDefault(
      overrides,
      'OPENROUTER_BASE_URL',
      DEFAULT_OPEN_ROUTER_BASE_URL,
    ),
    openRouterReferer: readText(overrides, 'OPENROUTER_REFERER') ?? null,
    openRouterAppTitle: readText(overrides, 'OPENROUTER_APP_TITLE') ?? null,
    model: readTextOrDefault(overrides, 'OPENROUTER_MODEL', DEFAULT_MODEL),
    dataDir: resolvePath(process.cwd(), readTextOrDefault(overrides, 'DATA_DIR', DEFAULT_DATA_DIR)),
    port: readPort(overrides),
    host: readTextOrDefault(overrides, 'HOST', DEFAULT_HOST),
    stubProvider: readStubProvider(overrides),
    providerConfigured: openRouterApiKey !== null,
  };

  return Object.freeze(config);
}
