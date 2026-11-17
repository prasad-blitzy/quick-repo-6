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
import { isValidImageId } from '../../src/domain/ids.js';

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
 * The image ids the recorded synthesis answers carry, one per screenshot they are recorded
 * against.
 *
 * A recorded answer cannot know the ids the server will mint for a live submission, so each
 * envelope is recorded against these fixed canonical ids. The replay adapter answers with a
 * recording verbatim — the domain resolves a proposed price by exact equality and consults the
 * cited ids only to break a tie between levels sharing one — while a suite that wants a
 * submission's own ids in `src` binds them with {@link bindRecordedSources}. Each value is a
 * lowercase RFC 4122 version-4 UUID — the exact string the server writes into the
 * `image_id=<id>` label it sends to the synthesis call — and it names the screenshot whose
 * `extraction-<stem>.json` envelope the answer rests on, so a `src` entry always stands for an
 * image whose prices the answer is allowed to cite.
 */
export const RECORDED_SOURCE_IMAGE_IDS: Record<'footprint-es-5m' | 'gex-es-levels', string> = {
  'footprint-es-5m': '3f7a1c58-2d94-4b6e-8f13-5c9d0a7e4b28',
  'gex-es-levels': '9c40e2b7-6a15-4d38-b0f9-2e7a5c1d8063',
};

/** A screenshot stem a recorded synthesis answer presupposes, keyed by its recorded image id. */
export type RecordedSourceStem = keyof typeof RECORDED_SOURCE_IMAGE_IDS;

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

/**
 * Read one recorded synthesis envelope by scenario name.
 *
 * Every `src` entry is checked against the server's own image-id guard, because `src` must hold
 * the ids of the images the read rests on: a placeholder token can neither match an
 * `image_id=<id>` label the server sends nor name a submitted image, so a suite replayed against
 * one would assert an answer no real call can return.
 */
export function recordedSynthesis(scenario: RecordedSynthesisScenario): RecordedChatCompletion {
  const envelope = loadRecorded(`synthesis-${scenario}`);
  for (const imageId of synthesisSourceIds(envelope)) {
    if (!isValidImageId(imageId)) {
      throw new Error(
        `Recorded synthesis envelope "synthesis-${scenario}" carries the src entry "${imageId}", ` +
          `which is not a canonical image id. Every src entry must be the id of a submitted image, ` +
          `spelled exactly as the image_id label spells it; record the id in RECORDED_SOURCE_IMAGE_IDS ` +
          `and carry it in the fixture.`,
      );
    }
  }
  return envelope;
}

export function recordedAdversarial(kind: RecordedAdversarialKind): RecordedChatCompletion {
  return readEnvelopeAt(join(RECORDED_DIR, ADVERSARIAL_DIR_NAME, `${assertBareName(kind)}.json`));
}

/** The answer line the provider returned, exactly as recorded. */
export function recordedAnswerLine(envelope: RecordedChatCompletion): string {
  return firstChoice(envelope).message.content;
}

/**
 * The image ids a recorded synthesis answer rests on, in the order the answer lists them.
 *
 * `src` is the only record of which screenshots a read presupposes, so it is read back out of the
 * answer line itself rather than declared beside it, where the two could drift apart. The line
 * must be one line of JSON holding a single object whose `src` is an array of strings — the same
 * contract the server enforces — and anything else throws rather than handing a caller a list it
 * would silently compare against.
 */
export function synthesisSourceIds(envelope: RecordedChatCompletion): readonly string[] {
  return parseSynthesisSourceIds(recordedAnswerLine(envelope));
}

/**
 * The screenshot stems a recorded synthesis scenario presupposes, derived from the loaded
 * envelope's own `src` so the presupposition cannot drift from the fixture.
 *
 * Throws when an id is not one of {@link RECORDED_SOURCE_IMAGE_IDS}, naming the scenario and the
 * offending id: an answer naming an image no recorded extraction describes cannot be paired with
 * a submission, and a suite that guessed the pairing would prove the wrong thing.
 */
export function recordedSynthesisSourceStems(
  scenario: RecordedSynthesisScenario,
): readonly RecordedSourceStem[] {
  return synthesisSourceIds(recordedSynthesis(scenario)).map((imageId) => {
    const stem = sourceStemOf(imageId);
    if (stem === undefined) {
      throw new Error(
        `Recorded synthesis envelope "synthesis-${scenario}" names the src id "${imageId}", which is ` +
          `not one of RECORDED_SOURCE_IMAGE_IDS' values, so the screenshot it presupposes cannot be ` +
          `stated. Record the answer against the ids that table holds.`,
      );
    }
    return stem;
  });
}

/**
 * Rebind a recorded synthesis answer onto the image ids a live submission generated.
 *
 * A recorded answer cannot know the UUIDs the server mints for a submission, so an envelope on
 * disk carries the fixed ids in {@link RECORDED_SOURCE_IMAGE_IDS}. The replay adapter aligns those
 * citations onto the images the submission holds before the domain reads them as evidence, so a
 * replayed read cites sources the analysis actually has. This function remains for the cases that
 * supply their own answer — a scripted line, or a document built by hand — and equips it with the
 * ids the case received. Only the `src` array is rewritten; the
 * prices, the codes and the sentence stay exactly as recorded, and the input envelope is never
 * mutated — the returned envelope is a fresh one.
 *
 * Throws when a recorded id is not one of {@link RECORDED_SOURCE_IMAGE_IDS}' values, when the
 * presupposed stem has no submitted id, when a submitted value is not a valid image id, or when
 * two distinct recorded ids would collapse onto one submitted id: that collapse would leave `src`
 * naming fewer images than the answer rests on and would silently make a directional read look
 * like a single-source one.
 */
export function bindRecordedSources(
  envelope: RecordedChatCompletion,
  submittedImageIds: Readonly<Partial<Record<RecordedSourceStem, string>>>,
): RecordedChatCompletion {
  const line = recordedAnswerLine(envelope);
  const recordedSourceIds = parseSynthesisSourceIds(line);

  const submittedSourceIds: string[] = [];
  const recordedIdBySubmittedId = new Map<string, string>();
  for (const recordedId of recordedSourceIds) {
    const stem = sourceStemOf(recordedId);
    if (stem === undefined) {
      throw new Error(
        `bindRecordedSources cannot rebind the recorded src id "${recordedId}", which is not one of ` +
          `RECORDED_SOURCE_IMAGE_IDS' values, so the image it stands for is unknown.`,
      );
    }
    const submitted = submittedImageIds[stem];
    if (submitted === undefined) {
      throw new Error(
        `bindRecordedSources needs the id the submission generated for the "${stem}" image, which ` +
          `the recorded answer rests on, but no id for that stem was supplied.`,
      );
    }
    if (!isValidImageId(submitted)) {
      throw new Error(
        `bindRecordedSources was given "${submitted}" as the id of the "${stem}" image, which is not ` +
          `a canonical image id and so cannot be the body of an image_id label.`,
      );
    }
    const boundRecordedId = recordedIdBySubmittedId.get(submitted);
    if (boundRecordedId !== undefined && boundRecordedId !== recordedId) {
      throw new Error(
        `bindRecordedSources would collapse the recorded src ids "${boundRecordedId}" and ` +
          `"${recordedId}" onto the single submitted id "${submitted}", leaving src with fewer ` +
          `distinct images than the answer rests on.`,
      );
    }
    recordedIdBySubmittedId.set(submitted, recordedId);
    submittedSourceIds.push(submitted);
  }

  const reboundLine = withSourceIds(line, submittedSourceIds);
  const reboundSourceIds = parseSynthesisSourceIds(reboundLine);
  if (
    reboundSourceIds.length !== submittedSourceIds.length ||
    submittedSourceIds.some((imageId, index) => reboundSourceIds[index] !== imageId)
  ) {
    throw new Error(
      `bindRecordedSources could not rewrite the src array of the recorded answer line: the result ` +
        `holds [${reboundSourceIds.join(', ')}] where [${submittedSourceIds.join(', ')}] was bound.`,
    );
  }

  return {
    ...envelope,
    choices: envelope.choices.map((choice, index) =>
      index === 0 ? { ...choice, message: { ...choice.message, content: reboundLine } } : choice,
    ),
  };
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

/** The key that opens the answer's `src` array. */
const SOURCE_IDS_KEY = '"src"';

/**
 * Read the `src` array out of one answer line, admitting only the shape the server itself
 * requires: no line break, a single JSON object and nothing else, and a `src` array of strings.
 */
function parseSynthesisSourceIds(line: string): readonly string[] {
  if (line.includes('\n') || line.includes('\r')) {
    throw new Error(
      'A recorded synthesis answer must be exactly one line, but the recorded answer carries a line break.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`A recorded synthesis answer is not valid JSON: ${reason}`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A recorded synthesis answer must hold exactly one JSON object and nothing else.');
  }

  const { src } = parsed as Record<string, unknown>;
  if (!Array.isArray(src)) {
    throw new Error('A recorded synthesis answer must carry "src" as an array of image ids.');
  }

  const sourceIds: string[] = [];
  for (const [index, entry] of src.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(
        `A recorded synthesis answer must carry "src[${index}]" as an image-id string, not ${typeof entry}.`,
      );
    }
    sourceIds.push(entry);
  }
  return sourceIds;
}

/** The recorded stem an id belongs to, or `undefined` when no recorded id has that value. */
function sourceStemOf(imageId: string): RecordedSourceStem | undefined {
  for (const stem of Object.keys(RECORDED_SOURCE_IMAGE_IDS) as RecordedSourceStem[]) {
    if (RECORDED_SOURCE_IMAGE_IDS[stem] === imageId) {
      return stem;
    }
  }
  return undefined;
}

/**
 * Replace the answer line's `src` array text, leaving every other byte of the line untouched.
 * Re-serialising the parsed object instead would rewrite the recorded prices — `5845.00` would
 * come back as `5845` — and lose the byte fidelity the recorded answer is cited for.
 */
function withSourceIds(line: string, sourceIds: readonly string[]): string {
  const keyAt = line.indexOf(SOURCE_IDS_KEY);
  const arrayAt = keyAt === -1 ? -1 : line.indexOf('[', keyAt);
  if (arrayAt === -1) {
    throw new Error('A recorded synthesis answer must carry a "src" array to rebind.');
  }
  const arrayEnd = line.indexOf(']', arrayAt);
  if (arrayEnd === -1) {
    throw new Error('The "src" array of a recorded synthesis answer is not closed.');
  }
  const arrayText = `[${sourceIds.map((imageId) => JSON.stringify(imageId)).join(',')}]`;
  return `${line.slice(0, arrayAt)}${arrayText}${line.slice(arrayEnd + 1)}`;
}
