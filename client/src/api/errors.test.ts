/**
 * Suite for the client's error-body reader: every code in the shared vocabulary keeps the sentence
 * the server sent, a body that carries no usable sentence takes the shared sentence for its code,
 * and a body the interface cannot read a code from takes the fallback body.
 */

import { describe, expect, it } from 'vitest';

import { ERROR_CODES, ERROR_MESSAGES } from '@trade-read/shared';

import { messageForCode, parseErrorBody } from './errors';

/** A sentence shaped like the server's: it names the file it refused. */
const SERVER_SENTENCE = 'chart-one.png is not a PNG, JPEG or WebP image.';

const FALLBACK_BODY = {
  code: 'INTERNAL_ERROR',
  message: ERROR_MESSAGES.INTERNAL_ERROR,
} as const;

/** One entry per shape of body the interface cannot read a code from. */
const UNUSABLE_BODIES: ReadonlyArray<readonly [string, string]> = [
  ['an HTML error page', '<html><body>oops</body></html>'],
  ['an empty body', ''],
  ['a JSON null', 'null'],
  ['a JSON array', '[]'],
  ['a bare JSON string naming a code', '"NO_IMAGES"'],
  ['a bare JSON number', '7'],
  ['an object with no code', '{"message":"x"}'],
  ['a code outside the vocabulary', '{"code":"WAT","message":"x"}'],
  ['a code that is not a string', '{"code":42,"message":"x"}'],
  ['a truncated body', '{"code":"NOT_FOUND"'],
];

describe('parseErrorBody', () => {
  it.each(ERROR_CODES)('keeps the server code and sentence for %s', (code) => {
    expect(parseErrorBody(JSON.stringify({ code, message: SERVER_SENTENCE }))).toEqual({
      code,
      message: SERVER_SENTENCE,
    });
  });

  it.each(ERROR_CODES)('uses the shared sentence for %s when the body carries none', (code) => {
    expect(parseErrorBody(JSON.stringify({ code }))).toEqual({
      code,
      message: ERROR_MESSAGES[code],
    });
    expect(parseErrorBody(JSON.stringify({ code, message: '   ' }))).toEqual({
      code,
      message: ERROR_MESSAGES[code],
    });
  });

  it('trims the sentence it keeps', () => {
    expect(
      parseErrorBody(JSON.stringify({ code: 'NOT_FOUND', message: `  ${SERVER_SENTENCE}  ` })),
    ).toEqual({ code: 'NOT_FOUND', message: SERVER_SENTENCE });
  });

  it.each(UNUSABLE_BODIES)('answers %s with the fallback body', (_shape, body) => {
    expect(parseErrorBody(body)).toEqual(FALLBACK_BODY);
  });

  it('shows the mapping sentence when a body names no known code', () => {
    expect(parseErrorBody('{"code":"WAT"}')).toEqual({
      code: 'INTERNAL_ERROR',
      message: messageForCode('INTERNAL_ERROR'),
    });
  });
});
