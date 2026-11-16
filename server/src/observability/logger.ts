/**
 * The server's only writer: one JSON line per event on stdout.
 *
 * Every diagnostic the server emits goes through `createLogger`. No other module may
 * log to the console, write to stdout, or format a log line of its own.
 *
 * What may never reach a log line, in a field:
 * - the model credential (or a prefix of it) and an `Authorization` header;
 * - a request body or an outgoing provider request payload;
 * - image bytes, a `Buffer`/`Uint8Array`, or a `data:<mime>;base64,` string.
 *
 * The one line that carries provider error text is the conformance failure, whose raw
 * answer text travels in `message` only. `message` must never be given the request
 * body, the `Authorization` header, or an image buffer/base64 string; the redaction
 * pass below is defence in depth, not permission to pass them.
 */

/** Severity of one log line. `duration()` logs at `'info'`. */
export type LogLevel = 'info' | 'error';

/**
 * The complete, closed set of fields one log line may carry.
 *
 * There is deliberately no index signature and no field able to hold a header map, a
 * request body, an `Error`, a `Buffer`, a `Uint8Array` or a nested object: the field
 * set itself is what keeps those shapes out of the log. Adding a field is a deliberate
 * code change here, at the type and in `LOG_EVENT_KEYS`.
 */
export interface LogEvent {
  /** Short, stable snake_case event name, for example `server_started`. */
  event: string;
  /** Identifier of the analysis the event belongs to. */
  analysisId?: string;
  /** Which model call the event describes. */
  role?: 'extraction' | 'synthesis';
  /** Completion tokens for a synthesis call, or the cumulative count on an analysis line. */
  tokens?: number;
  /** Elapsed milliseconds, an integer, never negative. */
  durationMs?: number;
  /** HTTP status of a provider response, mapped or raw. */
  status?: number;
  /** Whether a model credential is configured. A boolean, never the credential. */
  providerConfigured?: boolean;
  /** The configured model slug. */
  model?: string;
  /** The bound address reported at startup. */
  host?: string;
  /** The bound port reported at startup. */
  port?: number;
  /** Extraction calls issued for one analysis, retries included. */
  imageCount?: number;
  /** Short result word, for example `saved` or `deleted`. */
  outcome?: string;
  /** Short machine-readable cause of a conformance failure, for example `FENCE`. */
  reason?: string;
  /**
   * Free text. This is the only field that may carry a provider's raw answer text on a
   * conformance failure. Never assign it a request body, an `Authorization` header, an
   * image buffer or a base64 string.
   */
  message?: string;
}

/** The three emission points every caller uses. All synchronous, all `void`. */
export interface Logger {
  info(event: LogEvent): void;
  error(event: LogEvent): void;
  /** Emits at level `info` with `durationMs` measured from `startedAt`. */
  duration(event: LogEvent, startedAt: number): void;
}

/** Injection points used by tests; both optional, both defaulted. */
export interface CreateLoggerOptions {
  /** Receives one complete line, trailing newline included. */
  write?: (line: string) => void;
  /** Millisecond clock used for `ts` and for `duration()`. */
  now?: () => number;
}

/**
 * The closed field set in canonical serialisation order: `event` first, then every
 * optional field in declaration order. Serialisation reads only these keys, so a key a
 * caller injects at runtime cannot be emitted even when the type system is bypassed.
 */
const LOG_EVENT_KEYS = [
  'event',
  'analysisId',
  'role',
  'tokens',
  'durationMs',
  'status',
  'providerConfigured',
  'model',
  'host',
  'port',
  'imageCount',
  'outcome',
  'reason',
  'message',
] as const;

type LogEventKey = (typeof LOG_EVENT_KEYS)[number];

/** A credential issued by the model gateway. */
const CREDENTIAL_PATTERN = /sk-or-[A-Za-z0-9._-]+/g;

/** An inline base64 payload, which is how image bytes would appear in text. */
const INLINE_BASE64_PATTERN = /data:[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** Raw line separators that are valid JSON but split lines in several log readers. */
const LINE_SEPARATOR_PATTERN = /[\u2028\u2029]/g;

/** Longest provider text kept in `message`; adversarial answers are far shorter. */
const MAX_MESSAGE_LENGTH = 2000;

/** Marker appended to `message` when it was longer than `MAX_MESSAGE_LENGTH`. */
const TRUNCATION_SUFFIX = '\u2026(truncated)';

const REDACTED = '[redacted]';

function escapeLineSeparators(serialised: string): string {
  return serialised.replace(LINE_SEPARATOR_PATTERN, (separator: string): string =>
    separator === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

/** Replaces credential-shaped and inline-base64 runs, then caps the value if asked to. */
function redact(value: string, maxLength?: number): string {
  const cleaned = value
    .replace(CREDENTIAL_PATTERN, REDACTED)
    .replace(INLINE_BASE64_PATTERN, REDACTED);
  if (maxLength === undefined || cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength) + TRUNCATION_SUFFIX;
}

/**
 * Decides whether a value may be emitted for a field the type declares as a primitive.
 * Objects, arrays, functions and buffers are dropped rather than serialised, so a caller
 * that reaches the logger through a cast still cannot get bytes or headers into a line.
 */
function isSerialisableValue(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

/** Applies the per-field guards: drop unusable values, keep the declared vocabulary. */
function selectValue(key: LogEventKey, value: unknown): string | number | boolean | undefined {
  if (value === undefined || !isSerialisableValue(value)) {
    return undefined;
  }
  if (key === 'role') {
    return value === 'extraction' || value === 'synthesis' ? value : undefined;
  }
  if (key === 'message' && typeof value === 'string') {
    return redact(value, MAX_MESSAGE_LENGTH);
  }
  if (key === 'reason' && typeof value === 'string') {
    return redact(value);
  }
  return value;
}

/**
 * Builds one line: `ts` first, then `level`, then the allowlisted fields in canonical
 * order, serialised once with no indentation and terminated by a single newline.
 */
function serialise(level: LogLevel, event: LogEvent, now: () => number): string {
  const payload: Record<string, string | number | boolean> = {
    ts: new Date(now()).toISOString(),
    level,
  };
  for (const key of LOG_EVENT_KEYS) {
    const value = selectValue(key, event[key]);
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  return escapeLineSeparators(JSON.stringify(payload)) + '\n';
}

const defaultWrite = (line: string): void => {
  process.stdout.write(line);
};

const defaultNow = (): number => Date.now();

/**
 * Creates an independent logger. The writer and clock may be replaced so a test can
 * capture lines and make `ts` and `durationMs` deterministic.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? defaultNow;

  return {
    info(event: LogEvent): void {
      write(serialise('info', event, now));
    },

    error(event: LogEvent): void {
      write(serialise('error', event, now));
    },

    duration(event: LogEvent, startedAt: number): void {
      const elapsed = Number.isFinite(startedAt) ? now() - startedAt : 0;
      const durationMs = Math.max(0, Math.round(elapsed));
      write(serialise('info', { ...event, durationMs }, now));
    },
  };
}
