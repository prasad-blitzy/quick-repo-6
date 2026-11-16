/**
 * Recorded provider responses, replayed as full chat-completions envelopes.
 *
 * Every offline server suite answers the model with one of these envelopes rather than with a bare
 * answer string, so the production parser, the single-line conformance check, the truncation rule
 * and the completion-token accounting all execute against realistic input.
 *
 * This module is the only reader of `fixtures/recorded/**`. It never writes, never reads the
 * environment, and performs no filesystem work at import time.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The part of a chat-completions response body the suites replay and assert against. */
export interface RecordedChatCompletion {
  choices: Array<{
    index?: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  id?: string;
  model?: string;
}

/** Screenshots that each carry a recorded extraction envelope. */
export const RECORDED_EXTRACTION_STEMS = [
  'footprint-es-5m',
  'gex-es-levels',
  'dom-ladder-es',
  'volume-profile-es',
  'blank-uniform',
] as const;

/** Synthesis envelopes: the valid recommendations, the two downgrade fixtures and the out-of-vocabulary one. */
export const RECORDED_SYNTHESIS_SCENARIOS = [
  'long',
  'short',
  'no-trade',
  'unmatched-price',
  'single-source',
  'out-of-vocabulary',
] as const;

/** The four answers that break the one-line contract and must produce one retry then `502`. */
export const RECORDED_ADVERSARIAL_KINDS = [
  'two-line',
  'fenced',
  'trailing-sentence',
  'truncated',
] as const;

export type RecordedExtractionStem = (typeof RECORDED_EXTRACTION_STEMS)[number];
export type RecordedSynthesisScenario = (typeof RECORDED_SYNTHESIS_SCENARIOS)[number];
export type RecordedAdversarialKind = (typeof RECORDED_ADVERSARIAL_KINDS)[number];

/**
 * Absolute path of `fixtures/recorded`, derived from this module's own location so it does not
 * depend on the process working directory: `server/test/helpers` -> `server/test` -> `server` ->
 * repository root.
 */
export const RECORDED_DIR: string = resolve(
  fileURLToPath(new URL('../../../fixtures/recorded/', import.meta.url)),
);

/** Subdirectory holding the adversarial answers; joined here only, never by a caller. */
const ADVERSARIAL_DIR_NAME = 'adversarial';

function assertBareName(name: string): string {
  if (name.trim() === '') {
    throw new Error(
      'Recorded fixture name must not be blank; pass a bare file stem such as "synthesis-long".',
    );
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(
      `Recorded fixture name "${name}" must be a bare file stem without a path separator or ".."; ` +
        `subdirectories are joined by this helper, not by the caller.`,
    );
  }
  return name;
}

/** Absolute path of a recorded envelope, for a bare name such as `extraction-gex-es-levels`. */
export function recordedPath(name: string): string {
  return join(RECORDED_DIR, `${assertBareName(name)}.json`);
}

/**
 * Read one recorded envelope by bare name. Parsed afresh on every call so no suite can hand
 * another suite a mutated object.
 */
export function loadRecorded(name: string): RecordedChatCompletion {
  return readEnvelopeAt(recordedPath(name));
}

export function recordedExtraction(stem: RecordedExtractionStem): RecordedChatCompletion {
  return loadRecorded(`extraction-${stem}`);
}

export function recordedSynthesis(scenario: RecordedSynthesisScenario): RecordedChatCompletion {
  return loadRecorded(`synthesis-${scenario}`);
}

export function recordedAdversarial(kind: RecordedAdversarialKind): RecordedChatCompletion {
  return readEnvelopeAt(join(RECORDED_DIR, ADVERSARIAL_DIR_NAME, `${assertBareName(kind)}.json`));
}

/** The answer line the provider returned, exactly as recorded. */
export function recordedAnswerLine(envelope: RecordedChatCompletion): string {
  return firstChoice(envelope).message.content;
}

/** The synthesis completion cost the conformance and cost assertions compare against the ceiling. */
export function recordedCompletionTokens(envelope: RecordedChatCompletion): number {
  const tokens: unknown = envelope.usage.completion_tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
    throw new Error(
      'A recorded provider envelope must carry usage.completion_tokens as a finite number.',
    );
  }
  return tokens;
}

function firstChoice(envelope: RecordedChatCompletion): RecordedChatCompletion['choices'][number] {
  const [choice] = envelope.choices;
  if (choice === undefined) {
    throw new Error('A recorded provider envelope must carry at least one choice.');
  }
  return choice;
}

function readEnvelopeAt(absolutePath: string): RecordedChatCompletion {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Recorded provider envelope is missing or unreadable at ${absolutePath}. ` +
        `fixtures/recorded/** is committed with this repository and must exist as checked out; ` +
        `no generation step produces these files. Original error: ${reason}`,
      { cause },
    );
  }
  return parseEnvelope(absolutePath, raw);
}

function parseEnvelope(absolutePath: string, raw: string): RecordedChatCompletion {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Recorded provider envelope at ${absolutePath} is not valid JSON: ${reason}`,
      { cause },
    );
  }
  assertEnvelope(absolutePath, parsed);
  return parsed as RecordedChatCompletion;
}

/**
 * Fail loudly on a malformed envelope rather than handing a caller an `undefined` field it would
 * then compare against. The adversarial fixtures are deliberately non-conforming in their answer
 * *content*, which this shape check leaves untouched: it judges only the envelope, never the line.
 */
function assertEnvelope(absolutePath: string, value: unknown): void {
  const envelope = asRecord(absolutePath, value, 'envelope');

  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw shapeError(absolutePath, 'choices', 'a non-empty array');
  }
  choices.forEach((entry, index) => {
    const choice = asRecord(absolutePath, entry, `choices[${index}]`);
    const message = asRecord(absolutePath, choice.message, `choices[${index}].message`);
    assertString(absolutePath, message.role, `choices[${index}].message.role`);
    assertString(absolutePath, message.content, `choices[${index}].message.content`);
    assertString(absolutePath, choice.finish_reason, `choices[${index}].finish_reason`);
    if (choice.index !== undefined) {
      assertFiniteNumber(absolutePath, choice.index, `choices[${index}].index`);
    }
  });

  const usage = asRecord(absolutePath, envelope.usage, 'usage');
  assertFiniteNumber(absolutePath, usage.prompt_tokens, 'usage.prompt_tokens');
  assertFiniteNumber(absolutePath, usage.completion_tokens, 'usage.completion_tokens');
  assertFiniteNumber(absolutePath, usage.total_tokens, 'usage.total_tokens');

  if (envelope.id !== undefined) {
    assertString(absolutePath, envelope.id, 'id');
  }
  if (envelope.model !== undefined) {
    assertString(absolutePath, envelope.model, 'model');
  }
}

function shapeError(absolutePath: string, field: string, expected: string): Error {
  return new Error(
    `Recorded provider envelope at ${absolutePath} is malformed: field "${field}" must be ${expected}.`,
  );
}

function asRecord(absolutePath: string, value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw shapeError(absolutePath, field, 'an object');
  }
  return value as Record<string, unknown>;
}

function assertString(absolutePath: string, value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw shapeError(absolutePath, field, 'a string');
  }
  return value;
}

function assertFiniteNumber(absolutePath: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw shapeError(absolutePath, field, 'a finite number');
  }
  return value;
}
