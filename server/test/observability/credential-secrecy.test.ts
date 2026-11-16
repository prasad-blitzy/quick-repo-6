import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/env.js';
import { sanitizeSlug } from '../../src/domain/errors.js';
import { createLogger, type LogEvent } from '../../src/observability/logger.js';
import { createHealthRouter } from '../../src/routes/health-routes.js';

/**
 * The two channels through which a configured value reaches an operator: the log line and the
 * health response body. Both live in this suite because the same defect — a value emitted exactly as
 * it was configured — can reappear on either, and because both render the model slug through the
 * same sanitiser. What is asserted here is the secrecy the log and the body must keep, not the
 * behaviour of a single module.
 *
 * The credential-shaped literal is assembled from parts at run time, so this file carries no
 * credential shape of its own for a scanner to find.
 */

/** A configured value in the gateway's credential format, built here rather than written out. */
const CREDENTIAL_SHAPED_VALUE = ['sk-or', 'v1', 'DEADBEEFCAFE'].join('-');

/** The base64 of a 1x1 PNG, the shortest realistic form of an inline image payload. */
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A fixed clock, so `ts` is deterministic and a line can be compared byte for byte. */
const FIXED_NOW = 1_763_300_000_000;

/** Every field of {@link LogEvent} that carries a string, so redaction is asserted on all of them. */
const STRING_FIELDS = ['event', 'analysisId', 'model', 'host', 'outcome', 'reason', 'message'] as const;

/** Clock readings a `Date` cannot represent; each one used to make a log call throw. */
const UNUSABLE_CLOCKS: ReadonlyArray<readonly [string, () => number]> = [
  ['not a number', () => Number.NaN],
  ['above the representable range', () => 1e20],
  ['below the representable range', () => -1e20],
  ['infinite', () => Number.POSITIVE_INFINITY],
];

/** Captures the lines a logger writes, so an assertion reads exactly what was emitted. */
function captureLines(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string): void => void lines.push(line) };
}

/** Serialises one event through a logger with a fixed clock and returns the parsed line. */
function lineFor(event: LogEvent, clock: () => number = () => FIXED_NOW): Record<string, unknown> {
  const { lines, write } = captureLines();
  createLogger({ write, now: clock }).info(event);
  const line = lines[0] ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

describe('a log line never carries a credential or image bytes', () => {
  it.each(STRING_FIELDS)('redacts a credential-shaped %s', (field) => {
    const { lines, write } = captureLines();
    createLogger({ write, now: () => FIXED_NOW }).info({
      event: 'analysis_saved',
      [field]: CREDENTIAL_SHAPED_VALUE,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('DEADBEEFCAFE');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ [field]: '[redacted]' });
  });

  it('redacts a bare base64 run that carries no data: prefix', () => {
    const { lines, write } = captureLines();
    createLogger({ write, now: () => FIXED_NOW }).info({ event: 'conformance_failed', message: IMAGE_BASE64 });

    expect(lines[0]).not.toContain('iVBORw0KGgo');
  });

  it('redacts a base64 payload carried under a data: prefix', () => {
    const { lines, write } = captureLines();
    createLogger({ write, now: () => FIXED_NOW }).info({
      event: 'conformance_failed',
      message: `data:image/png;base64,${IMAGE_BASE64}`,
    });

    expect(lines[0]).not.toContain('iVBORw0KGgo');
  });

  it('leaves a legitimate slug, id, event name, outcome, reason and host untouched', () => {
    const analysisId = '3f2b1c9e-1d4a-4b7c-8e2f-0a1b2c3d4e5f';
    const parsed = lineFor({
      event: 'analysis_saved',
      analysisId,
      model: 'google/gemini-2.5-flash',
      host: '127.0.0.1',
      outcome: 'saved',
      reason: 'FENCE',
    });

    expect(parsed).toMatchObject({
      event: 'analysis_saved',
      analysisId,
      model: 'google/gemini-2.5-flash',
      host: '127.0.0.1',
      outcome: 'saved',
      reason: 'FENCE',
    });
  });

  it('caps message and leaves a short provider answer intact', () => {
    const answer = '{"l":[[5845.00,"GCW"]],"o":"LAST=5840.00","r":"OK"}';
    const { lines, write } = captureLines();
    const logger = createLogger({ write, now: () => FIXED_NOW });

    logger.info({ event: 'conformance_failed', message: 'x'.repeat(5000) });
    logger.info({ event: 'conformance_failed', message: answer });

    const capped = JSON.parse(lines[0] ?? '') as { message: string };
    expect(capped.message.length).toBeLessThan(5000);
    expect(capped.message.endsWith('\u2026(truncated)')).toBe(true);
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ message: answer });
  });

  it('drops a Buffer, a header map and a key the closed field set does not name', () => {
    const { lines, write } = captureLines();
    const bypassingCast = {
      event: 'server_started',
      buffer: Buffer.from('image bytes'),
      headers: { authorization: CREDENTIAL_SHAPED_VALUE },
    } as unknown as LogEvent;

    createLogger({ write, now: () => FIXED_NOW }).info(bypassingCast);

    expect(Object.keys(JSON.parse(lines[0] ?? ''))).toEqual(['ts', 'level', 'event']);
  });

  it('emits every field of the closed set, in canonical order, on one line', () => {
    const { lines, write } = captureLines();
    createLogger({ write, now: () => FIXED_NOW }).info({
      event: 'analysis_completed',
      analysisId: '3f2b1c9e-1d4a-4b7c-8e2f-0a1b2c3d4e5f',
      role: 'synthesis',
      tokens: 96,
      durationMs: 42,
      status: 200,
      providerConfigured: true,
      model: 'google/gemini-2.5-flash',
      host: '127.0.0.1',
      port: 3001,
      imageCount: 2,
      outcome: 'saved',
      reason: 'FENCE',
      message: 'answer text',
    });

    const line = lines[0] ?? '';
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(Object.keys(JSON.parse(line))).toEqual([
      'ts',
      'level',
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
    ]);
  });
});

describe('an unusable clock cannot make a log call fail', () => {
  it.each(UNUSABLE_CLOCKS)('stamps the epoch when the clock reads %s', (_label, clock) => {
    expect(lineFor({ event: 'analysis_saved' }, clock)).toMatchObject({
      ts: new Date(0).toISOString(),
      event: 'analysis_saved',
    });
  });

  it.each(UNUSABLE_CLOCKS)('does not throw out of duration() when the clock reads %s', (_label, clock) => {
    const { lines, write } = captureLines();
    expect(() => {
      createLogger({ write, now: clock }).duration({ event: 'analysis_completed' }, FIXED_NOW);
    }).not.toThrow();
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 'info' });
  });
});

describe('the level set distinguishes a concern from a failure', () => {
  it('emits warn for an event worth attention that is not a failure', () => {
    const { lines, write } = captureLines();
    createLogger({ write, now: () => FIXED_NOW }).warn({
      event: 'conformance_retry',
      analysisId: '3f2b1c9e-1d4a-4b7c-8e2f-0a1b2c3d4e5f',
      role: 'extraction',
      reason: 'FENCE',
    });

    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'warn',
      event: 'conformance_retry',
      reason: 'FENCE',
    });
  });

  it('keeps info, warn and error as three distinct levels', () => {
    const { lines, write } = captureLines();
    const logger = createLogger({ write, now: () => FIXED_NOW });

    logger.info({ event: 'a' });
    logger.warn({ event: 'b' });
    logger.error({ event: 'c' });

    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      'info',
      'warn',
      'error',
    ]);
  });
});

describe('the health body never carries a credential or markup', () => {
  /** Mounts the real router the way the composition root does, under the API base path. */
  function healthApp(overrides: Record<string, string>): express.Express {
    const app = express();
    app.use('/api/v1', createHealthRouter({ config: loadConfig(overrides) }));
    return app;
  }

  it('redacts a credential-shaped configured slug', async () => {
    const response = await request(
      healthApp({ OPENROUTER_MODEL: CREDENTIAL_SHAPED_VALUE, OPENROUTER_API_KEY: '' }),
    ).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('DEADBEEFCAFE');
    expect(response.body).toMatchObject({ status: 'ok', providerConfigured: false, model: '[redacted]' });
  });

  it('answers with exactly status, providerConfigured and model', async () => {
    const response = await request(healthApp({ OPENROUTER_MODEL: 'google/gemini-2.5-flash' })).get(
      '/api/v1/health',
    );

    expect(Object.keys(response.body)).toEqual(['status', 'providerConfigured', 'model']);
    expect(response.body).toMatchObject({
      status: 'ok',
      providerConfigured: false,
      model: 'google/gemini-2.5-flash',
    });
  });

  it('reports providerConfigured true when a credential is configured', async () => {
    const response = await request(
      healthApp({
        OPENROUTER_MODEL: 'google/gemini-2.5-flash',
        OPENROUTER_API_KEY: ['test', 'key'].join('-'),
      }),
    ).get('/api/v1/health');

    expect(response.body).toMatchObject({ providerConfigured: true, model: 'google/gemini-2.5-flash' });
  });

  it('renders the configured slug through the one shared sanitiser', async () => {
    const configured = 'google/gemini-2.5-flash\u0000<script>alert(1)</script>';
    const response = await request(healthApp({ OPENROUTER_MODEL: configured })).get('/api/v1/health');
    const model = response.body.model as string;

    expect(model).toBe(sanitizeSlug(configured));
    expect(model).toMatch(/^[A-Za-z0-9._:/-]*$/);
    expect(model).not.toMatch(/[\u0000<>()]/);
  });
});
