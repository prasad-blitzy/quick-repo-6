import { z } from 'zod';

/**
 * Every reason a model answer can fail conformance.
 *
 * The declaration order is the enumeration's identity, not the order the checks
 * run: `parseConformingAnswer` tests `TRUNCATED` first, because a provider
 * over-limit error can arrive as a completion flagged truncated with no text,
 * and treating that as merely empty would hide the real cause.
 */
export const CONFORMANCE_REASONS = [
  'EMPTY',
  'TRUNCATED',
  'FENCE',
  'INTERNAL_NEWLINE',
  'SURROUNDING_TEXT',
  'INVALID_JSON',
  'SCHEMA',
] as const;

export type ConformanceReason = (typeof CONFORMANCE_REASONS)[number];

export interface ConformanceSuccess<T> {
  readonly ok: true;
  /** The answer, already validated by the schema the caller supplied. */
  readonly value: T;
  /** The accepted line, trimmed of outer whitespace and free of newlines. */
  readonly line: string;
}

export interface ConformanceFailure {
  readonly ok: false;
  readonly reason: ConformanceReason;
  /** One sentence naming the check that failed; safe for the caller to record. */
  readonly message: string;
  /** The model's answer text exactly as it was received. */
  readonly raw: string;
}

export type ConformanceResult<T> = ConformanceSuccess<T> | ConformanceFailure;

/** The markdown fence sequence; its presence fails the answer wherever it sits. */
const CODE_FENCE = '```';

/** Upper bound on validation detail quoted into a failure message. */
const MAX_DETAIL_CHARS = 200;

/** The characters a single line of JSON may not contain. */
const LINE_BREAKS = ['\n', '\r'] as const;

/**
 * Decides whether a model answer honours the one-line JSON contract, and if not,
 * which check rejected it.
 *
 * Accepted answers are exactly one trimmed line holding one JSON object and
 * nothing else, flagged complete by the provider, and valid against `schema`.
 * Anything else is a failure carrying the reason, a short message and the raw
 * text; no object is ever returned unvalidated, so a vocabulary violation and a
 * malformed line are one and the same class of failure for the caller.
 *
 * The function is total and pure: it performs no I/O, holds no state, and
 * returns a result rather than throwing for every input it can be given.
 */
export function parseConformingAnswer<T>(
  raw: string | null | undefined,
  finishReason: string | null | undefined,
  schema: z.ZodType<T>,
): ConformanceResult<T> {
  const answer = raw ?? '';

  if (isTruncated(finishReason)) {
    return fail(
      'TRUNCATED',
      'The provider flagged the answer as cut off at the completion ceiling.',
      answer,
    );
  }

  const line = answer.trim();

  if (line === '') {
    return fail('EMPTY', 'The provider returned no answer text.', answer);
  }

  if (LINE_BREAKS.some((breakChar) => line.includes(breakChar))) {
    return fail(
      'INTERNAL_NEWLINE',
      'The answer spans more than one line; the contract is exactly one line of JSON.',
      answer,
    );
  }

  if (line.includes(CODE_FENCE)) {
    return fail(
      'FENCE',
      'The answer is wrapped in a markdown code fence.',
      answer,
    );
  }

  const opensObject = line.startsWith('{');
  const closesObject = line.endsWith('}');

  // An answer cut off mid-object lands here rather than in INVALID_JSON: it can
  // never close its brace, and the surrounding-text check runs before parsing.
  // Both reasons are the same class of failure to the caller, which retries once.
  if (!opensObject || !closesObject) {
    return fail(
      'SURROUNDING_TEXT',
      opensObject
        ? 'The answer carries text after the JSON object.'
        : 'The answer carries text before the JSON object.',
      answer,
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return fail('INVALID_JSON', 'The answer is not valid JSON.', answer);
  }

  return validateAgainstSchema(parsed, line, answer, schema);
}

function validateAgainstSchema<T>(
  parsed: unknown,
  line: string,
  answer: string,
  schema: z.ZodType<T>,
): ConformanceResult<T> {
  let result: ReturnType<z.ZodType<T>['safeParse']>;

  try {
    result = schema.safeParse(parsed);
  } catch (error) {
    return fail(
      'SCHEMA',
      `The answer could not be validated against the expected shape: ${describeError(error)}.`,
      answer,
    );
  }

  if (!result.success) {
    return fail(
      'SCHEMA',
      `The answer does not match the expected shape: ${describeIssues(result.error)}.`,
      answer,
    );
  }

  return { ok: true, value: result.data, line };
}

function fail(
  reason: ConformanceReason,
  message: string,
  answer: string,
): ConformanceFailure {
  return { ok: false, reason, message, raw: answer };
}

function isTruncated(finishReason: string | null | undefined): boolean {
  return (
    typeof finishReason === 'string' &&
    finishReason.trim().toLowerCase() === 'length'
  );
}

/** Names the first schema violation as `<path> <message>` so the cause is legible. */
function describeIssues(error: z.ZodError): string {
  const issue: z.core.$ZodIssue | undefined = error.issues[0];

  if (issue === undefined) {
    return 'the schema reported no issue';
  }

  const field = issue.path.map((segment) => String(segment)).join('.');

  return clip(field === '' ? issue.message : `${field} ${issue.message}`);
}

function describeError(error: unknown): string {
  return clip(error instanceof Error ? error.message : 'unknown validation failure');
}

function clip(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS
    ? `${detail.slice(0, MAX_DETAIL_CHARS)}…`
    : detail;
}
